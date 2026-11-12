import { relations, sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text } from 'drizzle-orm/pg-core';
import {
  application,
  serviceTypeEnum,
} from '../applications/application.schema';
import { bucket } from '../buckets/bucket.schema';
import { compose } from '../compose/compose.schema';
import { libsql } from '../databases/libsql/libsql.schema';
import { mariadb } from '../databases/mariadb/mariadb.schema';
import { mongo } from '../databases/mongo/mongo.schema';
import { mysql } from '../databases/mysql/mysql.schema';
import { postgres } from '../databases/postgres/postgres.schema';
import { redis } from '../databases/redis/redis.schema';
import { generateAppName, isoTimestamp, nanoidPk } from '../db/columns';
import { destination } from '../destinations/destination.schema';

// A volume backup tars a named Docker volume to an S3 destination,
// independent of database dumps. The owning service is one of the nine
// service tables (mounts precedent), keyed by the shared service_type
// discriminator; `schedule` is the cron expression, named as on the backup
// table (wiring lands with Phase 37).

/**
 * The parent that is set is the one `serviceType` names, as a database fact
 * — `mount`'s constraint one table over, and the argument for the
 * `CASE` half is stated once at `mount.schema.ts`' `mountParentMatchesServiceType`.
 *
 * The consequence is sharper here than on `mount`, which is why both were done
 * in one migration rather than the eight-`IS NULL`-terms form offered.
 * `VolumeBackupsService.serviceIdOf` resolves the owner through
 * `VOLUME_BACKUP_FK_FIELD[row.serviceType]`, and that owner is what decides
 * the *server the tar runs on* and the `appName` the tarball's S3 key is
 * prefixed with. A row whose discriminant and whose set column named different
 * Services would tar one Service's volume into the other's bucket prefix —
 * which is the prefix `restore` authorizes by.
 *
 * The `CASE` reads the discriminant as text. `'bucket'` joined the
 * `service_type` enum in 0126, and an install upgrading across 0126 and the
 * migration that added the `bucket_id` arm runs both in one transaction, where
 * Postgres refuses an enum value added in that same transaction ("unsafe use
 * of new value"). Compared as text, the arm names no enum value at all.
 */
export const volumeBackupParentMatchesServiceType = check(
  'volume_backup_parent_matches_service_type',
  sql`num_nonnulls("application_id", "compose_id", "libsql_id", "mariadb_id", "mongo_id", "mysql_id", "postgres_id", "redis_id", "bucket_id") = 1
    AND (CASE "service_type"::text
           WHEN 'application' THEN "application_id"
           WHEN 'compose'     THEN "compose_id"
           WHEN 'libsql'      THEN "libsql_id"
           WHEN 'mariadb'     THEN "mariadb_id"
           WHEN 'mongo'       THEN "mongo_id"
           WHEN 'mysql'       THEN "mysql_id"
           WHEN 'postgres'    THEN "postgres_id"
           WHEN 'redis'       THEN "redis_id"
           WHEN 'bucket'      THEN "bucket_id"
         END) IS NOT NULL`,
);

export const volumeBackup = pgTable(
  'volume_backup',
  {
    volumeBackupId: nanoidPk('volume_backup_id'),
    name: text('name').notNull(),
    /** The Docker volume that gets tarred. */
    volumeName: text('volume_name').notNull(),
    /** S3 path fragment between the service's appName and the tarball. */
    prefix: text('prefix').notNull(),
    // Every kind, a Bucket's own volume included.
    serviceType: serviceTypeEnum('service_type')
      .notNull()
      .default('application'),
    /** Names the local tarball staging dir and the run-log directory. */
    appName: text('app_name')
      .notNull()
      .unique()
      .$defaultFn(() => generateAppName('volume-backup')),
    /** Compose backups only: which service in the stack mounts the volume. */
    serviceName: text('service_name'),
    /** Stop the service while the tar runs (applications and compose only). */
    turnOff: boolean('turn_off').notNull().default(false),
    /** Cron expression — scheduling wiring lands with Phase 37. */
    schedule: text('schedule').notNull(),
    /** Prune target: keep the newest N tarballs after each run (null = all). */
    keepLatestCount: integer('keep_latest_count'),
    enabled: boolean('enabled'),
    applicationId: text('application_id').references(
      () => application.applicationId,
      { onDelete: 'cascade' },
    ),
    postgresId: text('postgres_id').references(() => postgres.postgresId, {
      onDelete: 'cascade',
    }),
    mariadbId: text('mariadb_id').references(() => mariadb.mariadbId, {
      onDelete: 'cascade',
    }),
    mongoId: text('mongo_id').references(() => mongo.mongoId, {
      onDelete: 'cascade',
    }),
    mysqlId: text('mysql_id').references(() => mysql.mysqlId, {
      onDelete: 'cascade',
    }),
    redisId: text('redis_id').references(() => redis.redisId, {
      onDelete: 'cascade',
    }),
    libsqlId: text('libsql_id').references(() => libsql.libsqlId, {
      onDelete: 'cascade',
    }),
    composeId: text('compose_id').references(() => compose.composeId, {
      onDelete: 'cascade',
    }),
    bucketId: text('bucket_id').references(() => bucket.bucketId, {
      onDelete: 'cascade',
    }),
    destinationId: text('destination_id')
      .notNull()
      .references(() => destination.destinationId, { onDelete: 'cascade' }),
    createdAt: isoTimestamp('created_at'),
  },
  () => [volumeBackupParentMatchesServiceType],
);

export const volumeBackupRelations = relations(volumeBackup, ({ one }) => ({
  destination: one(destination, {
    fields: [volumeBackup.destinationId],
    references: [destination.destinationId],
  }),
  application: one(application, {
    fields: [volumeBackup.applicationId],
    references: [application.applicationId],
  }),
  postgres: one(postgres, {
    fields: [volumeBackup.postgresId],
    references: [postgres.postgresId],
  }),
  mariadb: one(mariadb, {
    fields: [volumeBackup.mariadbId],
    references: [mariadb.mariadbId],
  }),
  mongo: one(mongo, {
    fields: [volumeBackup.mongoId],
    references: [mongo.mongoId],
  }),
  mysql: one(mysql, {
    fields: [volumeBackup.mysqlId],
    references: [mysql.mysqlId],
  }),
  redis: one(redis, {
    fields: [volumeBackup.redisId],
    references: [redis.redisId],
  }),
  libsql: one(libsql, {
    fields: [volumeBackup.libsqlId],
    references: [libsql.libsqlId],
  }),
  compose: one(compose, {
    fields: [volumeBackup.composeId],
    references: [compose.composeId],
  }),
  bucket: one(bucket, {
    fields: [volumeBackup.bucketId],
    references: [bucket.bucketId],
  }),
}));

export type VolumeBackup = typeof volumeBackup.$inferSelect;

/** The FK column a service type's volume backups hang off (list queries). */
export const volumeBackupServiceFk = {
  application: volumeBackup.applicationId,
  postgres: volumeBackup.postgresId,
  mysql: volumeBackup.mysqlId,
  mariadb: volumeBackup.mariadbId,
  mongo: volumeBackup.mongoId,
  redis: volumeBackup.redisId,
  compose: volumeBackup.composeId,
  libsql: volumeBackup.libsqlId,
  bucket: volumeBackup.bucketId,
} as const;
